/**
 * Machine tests — run without an LLM, Docker, or a browser:
 *   node test.ts
 *
 * Service slots are provided with stubs (machine.provide) — no executor
 * runs. Controlled stubs capture inputs and decide outcomes, so failure
 * routing (diagram vs infra), the fix loop, RESET-wins-over-in-flight, and
 * evidence parity (path/hash/outPath/theme/content/after) are testable
 * deterministically. Validate is two-phase (event-driven) — its tests
 * send BEGIN_VALIDATE/VALIDATE_DONE directly.
 */
import assert from "node:assert/strict";
import { type Actor, createActor, fromPromise, waitFor } from "xstate";
import {
  type EmbedServiceInput,
  type EmbedServiceOutput,
  embedViolation,
  failureOf,
  initialContext,
  type MermaidLimits,
  mermaidMachine,
  type RenderServiceInput,
  type RenderServiceOutput,
  renderViolation,
  validateViolation,
} from "./machine.ts";

const LIMITS: MermaidLimits = { maxValidateAttempts: 3 };

// ---------------------------------------------------------------------------
// Stub services (controllable: inputs recorded, outcomes scripted)
// ---------------------------------------------------------------------------

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Stubs = {
  renderInputs: RenderServiceInput[];
  embedInputs: EmbedServiceInput[];
  renderNext: (input: RenderServiceInput) => Promise<RenderServiceOutput>;
  embedNext: (input: EmbedServiceInput) => Promise<EmbedServiceOutput>;
};

function makeStubs(
  over: Partial<{
    render: Stubs["renderNext"];
    embed: Stubs["embedNext"];
  }> = {},
): Stubs {
  return {
    renderInputs: [],
    embedInputs: [],
    renderNext: over.render ?? (async (input) => ({ outPath: input.outPath })),
    embedNext:
      over.embed ??
      (async (input) => ({
        action: "replaced" as const,
        target: input.target,
      })),
  };
}

function makeMachine(stubs: Stubs) {
  return mermaidMachine.provide({
    actors: {
      renderService: fromPromise<RenderServiceOutput, RenderServiceInput>(
        async ({ input }) => {
          stubs.renderInputs.push(input);
          return stubs.renderNext(input);
        },
      ),
      embedService: fromPromise<EmbedServiceOutput, EmbedServiceInput>(
        async ({ input }) => {
          stubs.embedInputs.push(input);
          return stubs.embedNext(input);
        },
      ),
    },
  });
}

type Machine = ReturnType<typeof makeMachine>;

function makeActor(stubs: Stubs): Actor<Machine> {
  const a = createActor(makeMachine(stubs), { input: { limits: LIMITS } });
  a.start();
  return a;
}

const PATH = "/tmp/diagram.mmd";
const OUT = "/tmp/diagram.svg";
const OUT2 = "/tmp/diagram2.svg";
const TARGET = "/tmp/notes.md";
const HASH = "h1";
const HASH2 = "h2";
const CONTENT = "graph TD\n  A --> B\n";

const beginRender = (
  path = PATH,
  hash = HASH,
  content = CONTENT,
  outPath = OUT,
  theme?: string,
) => ({
  type: "BEGIN_RENDER" as const,
  path,
  hash,
  content,
  outPath,
  ...(theme !== undefined ? { theme } : {}),
});
const beginEmbed = (
  path = PATH,
  hash = HASH,
  target = TARGET,
  content = "graph TD\n  A --> B\n",
  after?: string,
) => ({
  type: "BEGIN_EMBED" as const,
  path,
  hash,
  target,
  content,
  ...(after !== undefined ? { after } : {}),
});

/** Drive to `validated` with PATH/HASH (validate is two-phase). */
function toValidated(a: Actor<Machine>, path = PATH, hash = HASH) {
  a.send({ type: "BEGIN_VALIDATE" });
  a.send({ type: "VALIDATE_DONE", path, hash, ok: true, errors: [] });
}

/** Drive one render to settle (validated | drafting); returns the actor. */
async function renderOnce(
  stubs: Stubs,
  over: {
    path?: string;
    hash?: string;
    content?: string;
    outPath?: string;
    theme?: string;
  } = {},
) {
  const a = makeActor(stubs);
  toValidated(a);
  a.send(
    beginRender(
      over.path ?? PATH,
      over.hash ?? HASH,
      over.content ?? CONTENT,
      over.outPath ?? OUT,
      over.theme,
    ),
  );
  await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
  return a;
}

let passed = 0;
let failed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n${e instanceof Error ? e.stack : String(e)}`);
  }
}

// --- drafting ------------------------------------------

await ok(
  "drafting: BEGIN_VALIDATE allowed; BEGIN_RENDER/BEGIN_EMBED rejected",
  () => {
    const a = makeActor(makeStubs());
    assert.equal(a.getSnapshot().value, "drafting");
    assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
    assert.equal(a.getSnapshot().can(beginRender()), false);
    assert.equal(a.getSnapshot().can(beginEmbed()), false);
  },
);

await ok(
  "RESET during validating wins; late VALIDATE_DONE is dropped, state not resurrected",
  () => {
    const a = makeActor(makeStubs());
    a.send({ type: "BEGIN_VALIDATE" });
    assert.equal(a.getSnapshot().value, "validating");
    a.send({ type: "RESET" });
    assert.equal(a.getSnapshot().value, "drafting");
    assert.deepEqual(a.getSnapshot().context, initialContext(LIMITS));
    // the in-flight result arrives after the reset: no handler in drafting
    // (validate is two-phase; drafting only accepts BEGIN_VALIDATE), dropped —
    // the machine does not resurrect `validated`
    a.send({
      type: "VALIDATE_DONE",
      path: PATH,
      hash: HASH,
      ok: true,
      errors: [],
    });
    assert.equal(a.getSnapshot().value, "drafting");
    assert.equal(a.getSnapshot().context.validated, null);
    assert.equal(a.getSnapshot().can(beginRender()), false);
  },
);

// --- validation (two-phase, event-driven — unchanged semantics) ---------------

await ok(
  "VALIDATE_DONE ok -> validated: source {path, hash} stored, errors cleared",
  () => {
    const a = makeActor(makeStubs());
    toValidated(a);
    assert.equal(a.getSnapshot().value, "validated");
    assert.deepEqual(a.getSnapshot().context.validated, {
      path: PATH,
      hash: HASH,
    });
    assert.equal(a.getSnapshot().context.validateAttempts, 0);
  },
);

await ok(
  "VALIDATE_DONE fail -> drafting: errors stored, attempts bumped, validated null",
  () => {
    const a = makeActor(makeStubs());
    a.send({ type: "BEGIN_VALIDATE" });
    a.send({
      type: "VALIDATE_DONE",
      path: PATH,
      hash: HASH,
      ok: false,
      errors: ["Parse error on line 2"],
    });
    assert.equal(a.getSnapshot().value, "drafting");
    assert.equal(a.getSnapshot().context.validated, null);
    assert.deepEqual(a.getSnapshot().context.errors, ["Parse error on line 2"]);
    assert.equal(a.getSnapshot().context.validateAttempts, 1);
  },
);

await ok("drafting: BEGIN_VALIDATE allowed (fix loop)", () => {
  const a = makeActor(makeStubs());
  a.send({ type: "BEGIN_VALIDATE" });
  a.send({
    type: "VALIDATE_DONE",
    path: PATH,
    hash: HASH,
    ok: false,
    errors: ["bad"],
  });
  assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
  a.send({ type: "BEGIN_VALIDATE" });
  a.send({
    type: "VALIDATE_DONE",
    path: PATH,
    hash: HASH,
    ok: true,
    errors: [],
  });
  assert.equal(a.getSnapshot().value, "validated");
  // attempts never decay on success — cumulative session budget (decay
  // would reopen the render fix loop)
  assert.equal(a.getSnapshot().context.validateAttempts, 1);
});

await ok("validate attempts capped with readable reason; RESET frees", () => {
  const a = makeActor(makeStubs());
  for (let i = 0; i < LIMITS.maxValidateAttempts; i++) {
    assert.equal(
      a.getSnapshot().can({ type: "BEGIN_VALIDATE" }),
      true,
      `attempt ${i} should be allowed`,
    );
    a.send({ type: "BEGIN_VALIDATE" });
    a.send({
      type: "VALIDATE_DONE",
      path: PATH,
      hash: HASH,
      ok: false,
      errors: ["bad"],
    });
  }
  assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), false);
  assert.match(validateViolation(a.getSnapshot().context) ?? "", /exhausted/);
  // RESET always allowed from drafting
  a.send({ type: "RESET" });
  assert.equal(a.getSnapshot().value, "drafting");
  assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
});

await ok(
  "VALIDATE_DONE fail (infra) with prior pass -> validated, pass kept, no attempt bump",
  () => {
    const a = makeActor(makeStubs());
    toValidated(a);
    a.send({ type: "BEGIN_VALIDATE" });
    a.send({
      type: "VALIDATE_DONE",
      path: PATH,
      hash: HASH2,
      ok: false,
      errors: ["docker build failed"],
      cause: "infra",
    });
    assert.equal(a.getSnapshot().value, "validated");
    assert.deepEqual(a.getSnapshot().context.validated, {
      path: PATH,
      hash: HASH,
    }); // prior pass kept
    assert.equal(a.getSnapshot().context.validateAttempts, 0); // infra never burns attempts
    assert.deepEqual(a.getSnapshot().context.errors, ["docker build failed"]);
  },
);

await ok(
  "VALIDATE_DONE fail (infra) without prior pass -> drafting, no attempt bump",
  () => {
    const a = makeActor(makeStubs());
    a.send({ type: "BEGIN_VALIDATE" });
    a.send({
      type: "VALIDATE_DONE",
      path: PATH,
      hash: HASH,
      ok: false,
      errors: ["docker daemon down"],
      cause: "infra",
    });
    assert.equal(a.getSnapshot().value, "drafting");
    assert.equal(a.getSnapshot().context.validated, null);
    assert.equal(a.getSnapshot().context.validateAttempts, 0);
    assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true); // retry legal immediately
  },
);

await ok(
  "VALIDATE_DONE fail (diagram) still bumps attempts and clears pass",
  () => {
    const a = makeActor(makeStubs());
    toValidated(a);
    a.send({ type: "BEGIN_VALIDATE" });
    a.send({
      type: "VALIDATE_DONE",
      path: PATH,
      hash: HASH2,
      ok: false,
      errors: ["Parse error"],
      cause: "diagram",
    });
    assert.equal(a.getSnapshot().value, "drafting");
    assert.equal(a.getSnapshot().context.validated, null);
    assert.equal(a.getSnapshot().context.validateAttempts, 1);
  },
);

// --- render gating (pure validators — shared by guards + tool prechecks) ------

await ok(
  "validated: BEGIN_RENDER allowed only for the exact validated source",
  () => {
    const a = makeActor(makeStubs());
    toValidated(a);
    assert.equal(a.getSnapshot().can(beginRender()), true);
    assert.equal(a.getSnapshot().can(beginRender(PATH, HASH2)), false);
    assert.match(
      renderViolation(a.getSnapshot().context, PATH, HASH2) ?? "",
      /source changed since validation/,
    );
    assert.equal(
      a.getSnapshot().can(beginRender("/tmp/other.mmd", HASH)),
      false,
    );
    assert.match(
      renderViolation(a.getSnapshot().context, "/tmp/other.mmd", HASH) ?? "",
      /validated source is .* not/,
    );
  },
);

await ok("renderViolation: no validated source -> readable reason", () => {
  const a = makeActor(makeStubs());
  assert.match(
    renderViolation(a.getSnapshot().context, PATH, HASH) ?? "",
    /no validated source/,
  );
});

// --- render (machine-driven: the invoked renderService is stubbed) -------------

await ok(
  "renderService ok -> validated (render recorded); re-render allowed; evidence parity",
  async () => {
    const stubs = makeStubs();
    const a = await renderOnce(stubs, { theme: "forest" });
    assert.equal(a.getSnapshot().value, "validated"); // no separate `rendered` state — renders[] is the history
    assert.deepEqual(a.getSnapshot().context.renders, [OUT]);
    assert.equal(
      a.getSnapshot().can(beginRender(PATH, HASH, CONTENT, OUT2)),
      true,
    );
    // input evidence parity: the guarded path/hash flow into the service
    assert.equal(stubs.renderInputs.length, 1);
    // input evidence parity: guarded path/hash + the validated CONTENT flow
    // into the service (the executor renders the bytes, never a re-read)
    assert.deepEqual(stubs.renderInputs[0], {
      path: PATH,
      hash: HASH,
      content: CONTENT,
      outPath: OUT,
      theme: "forest",
    });
    // second render, second output
    a.send(beginRender(PATH, HASH, CONTENT, OUT2));
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    assert.deepEqual(a.getSnapshot().context.renders, [OUT, OUT2]);
  },
);

await ok(
  "renderService fail (diagram) -> drafting, pass cleared, retry render rejected, attempt bumped",
  async () => {
    const stubs = makeStubs({
      render: async () => {
        throw { errors: ["mmdc rejected"], cause: "diagram" };
      },
    });
    const a = await renderOnce(stubs);
    assert.equal(a.getSnapshot().value, "drafting");
    assert.equal(a.getSnapshot().context.validated, null); // drafting has no pass
    assert.deepEqual(a.getSnapshot().context.errors, ["mmdc rejected"]);
    assert.equal(a.getSnapshot().can(beginRender()), false); // must re-validate first
    // diagram-failed renders share the attempt cap (the render fix loop
    // gets the same flail stop as the validate loop); infra never bumps
    assert.equal(a.getSnapshot().context.validateAttempts, 1);
  },
);

await ok(
  "render fix loop hits the same cap: diagram-failed renders exhaust attempts, BEGIN_VALIDATE blocked",
  async () => {
    const stubs = makeStubs({
      render: async () => {
        throw { errors: ["mmdc rejected"], cause: "diagram" };
      },
    });
    const a = makeActor(stubs);
    for (let i = 0; i < LIMITS.maxValidateAttempts; i++) {
      toValidated(a); // validate ok — attempts must NOT decay (else the loop is unbounded)
      a.send(beginRender());
      await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
      assert.equal(a.getSnapshot().context.validateAttempts, i + 1);
    }
    assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), false);
    assert.match(validateViolation(a.getSnapshot().context) ?? "", /exhausted/);
  },
);

await ok(
  "renderService fail (shaped, no cause) defaults to diagram",
  async () => {
    const stubs = makeStubs({
      render: async () => {
        throw { errors: ["mmdc crashed"] };
      },
    });
    const a = await renderOnce(stubs);
    assert.equal(a.getSnapshot().value, "drafting");
    assert.equal(a.getSnapshot().context.validated, null);
  },
);

await ok(
  "renderService fail (non-shaped Error) -> infra: validated, pass kept, retry legal",
  async () => {
    const stubs = makeStubs({
      render: async () => {
        throw new Error("docker daemon down");
      },
    });
    const a = await renderOnce(stubs);
    assert.equal(a.getSnapshot().value, "validated");
    assert.deepEqual(a.getSnapshot().context.validated, {
      path: PATH,
      hash: HASH,
    }); // pass untouched
    assert.deepEqual(a.getSnapshot().context.errors, ["docker daemon down"]);
    assert.equal(a.getSnapshot().can(beginRender()), true); // retry without re-validate
    assert.equal(a.getSnapshot().context.validateAttempts, 0); // infra never burns attempts
  },
);

await ok(
  "renderService fail (shaped infra) -> validated, pass kept, errors recorded",
  async () => {
    const stubs = makeStubs({
      render: async () => {
        throw { errors: ["docker build failed"], cause: "infra" };
      },
    });
    const a = await renderOnce(stubs);
    assert.equal(a.getSnapshot().value, "validated");
    assert.deepEqual(a.getSnapshot().context.validated, {
      path: PATH,
      hash: HASH,
    });
    assert.deepEqual(a.getSnapshot().context.errors, ["docker build failed"]);
  },
);

await ok(
  "renderService fail (infra, empty errors) records fallback — `validated` + empty errors stays renderDone-only",
  async () => {
    const stubs = makeStubs({
      render: async () => {
        throw { errors: [], cause: "infra" };
      },
    });
    const a = await renderOnce(stubs);
    assert.equal(a.getSnapshot().value, "validated");
    assert.deepEqual(a.getSnapshot().context.validated, {
      path: PATH,
      hash: HASH,
    });
    // never empty: index.ts derives the render outcome from `validated` +
    // empty errors => success — that shape must stay renderDone-only
    assert.ok(a.getSnapshot().context.errors.length > 0);
  },
);

await ok(
  "BEGIN_RENDER/BEGIN_EMBED illegal while a render is in flight",
  async () => {
    const gate = deferred<RenderServiceOutput>();
    const stubs = makeStubs({ render: () => gate.promise });
    const a = makeActor(stubs);
    toValidated(a);
    a.send(beginRender());
    assert.equal(a.getSnapshot().value, "rendering");
    assert.equal(
      a.getSnapshot().can(beginRender(PATH, HASH, CONTENT, OUT2)),
      false,
    );
    assert.equal(a.getSnapshot().can(beginEmbed()), false);
    // settle the in-flight render
    gate.resolve({ outPath: OUT });
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    assert.equal(a.getSnapshot().value, "validated");
  },
);

await ok(
  "RESET wins over an in-flight render: service result dropped, renders empty",
  async () => {
    const gate = deferred<RenderServiceOutput>();
    const stubs = makeStubs({ render: () => gate.promise });
    const a = makeActor(stubs);
    toValidated(a);
    a.send(beginRender());
    assert.equal(a.getSnapshot().value, "rendering");
    a.send({ type: "RESET" });
    assert.equal(a.getSnapshot().value, "drafting");
    // the service settles after the reset: exiting `rendering` stopped the
    // actor — the late result has no handler and is dropped
    gate.resolve({ outPath: OUT });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(a.getSnapshot().context, initialContext(LIMITS));
    assert.equal(a.getSnapshot().context.renders.length, 0);
    assert.equal(a.getSnapshot().can(beginRender()), false);
  },
);

// --- embed gating (pure validators) ----------------------------------------------

await ok("validated: BEGIN_EMBED allowed; target === source rejected", () => {
  const a = makeActor(makeStubs());
  toValidated(a);
  assert.equal(a.getSnapshot().can(beginEmbed()), true);
  assert.equal(a.getSnapshot().can(beginEmbed(PATH, HASH, PATH)), false);
  assert.match(
    embedViolation(a.getSnapshot().context, PATH, HASH, PATH) ?? "",
    /target is the diagram source itself/,
  );
});

await ok("BEGIN_EMBED stale hash rejected with readable reason", () => {
  const a = makeActor(makeStubs());
  toValidated(a);
  assert.match(
    embedViolation(a.getSnapshot().context, PATH, HASH2, TARGET) ?? "",
    /source changed/,
  );
});

// --- embed (machine-driven: the invoked embedService is stubbed) ---------------

await ok(
  "embedService ok records embed (deduped); stays validated; evidence parity",
  async () => {
    const stubs = makeStubs();
    const a = makeActor(stubs);
    toValidated(a);
    a.send(beginEmbed(PATH, HASH, TARGET, "graph TD\n  A --> B\n", "## Notes"));
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    assert.equal(a.getSnapshot().value, "validated");
    assert.deepEqual(a.getSnapshot().context.embeds, [TARGET]);
    assert.equal(a.getSnapshot().context.errors.length, 0);
    // input evidence parity: content + after flow into the service
    assert.equal(stubs.embedInputs.length, 1);
    assert.deepEqual(stubs.embedInputs[0], {
      path: PATH,
      hash: HASH,
      target: TARGET,
      content: "graph TD\n  A --> B\n",
      after: "## Notes",
    });
    // re-embed same target: deduped history
    a.send(beginEmbed());
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    assert.deepEqual(a.getSnapshot().context.embeds, [TARGET]);
  },
);

await ok(
  "embedService fail (empty errors) records fallback; pass kept",
  async () => {
    const stubs = makeStubs({
      embed: async () => {
        throw { errors: [], cause: "infra" };
      },
    });
    const a = makeActor(stubs);
    toValidated(a);
    a.send(beginEmbed());
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    assert.equal(a.getSnapshot().value, "validated");
    assert.deepEqual(a.getSnapshot().context.validated, {
      path: PATH,
      hash: HASH,
    });
    // never empty: embedDone is the only exit of `embedding` leaving empty errors
    assert.ok(a.getSnapshot().context.errors.length > 0);
  },
);

await ok(
  "embedService fail records error; source stays validated (embedding is replace-safe)",
  async () => {
    const stubs = makeStubs({
      embed: async () => {
        throw new Error("target not found");
      },
    });
    const a = makeActor(stubs);
    toValidated(a);
    a.send(beginEmbed());
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    assert.equal(a.getSnapshot().value, "validated");
    assert.deepEqual(a.getSnapshot().context.validated, {
      path: PATH,
      hash: HASH,
    }); // pass kept
    assert.deepEqual(a.getSnapshot().context.errors, ["target not found"]);
    // still legal to retry embed immediately
    assert.equal(a.getSnapshot().can(beginEmbed()), true);
  },
);

await ok(
  "BEGIN_EMBED illegal while a render is in flight; embed legal after a render",
  async () => {
    const stubs = makeStubs();
    const a = makeActor(stubs);
    toValidated(a);
    a.send(beginRender());
    assert.equal(a.getSnapshot().can(beginEmbed()), false);
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    assert.equal(a.getSnapshot().value, "validated");
    assert.equal(a.getSnapshot().can(beginEmbed()), true);
  },
);

// --- re-validation ---------------------------------------------------------------

await ok(
  "re-validate changed source: new hash replaces the pass; stale hash rejected",
  () => {
    const a = makeActor(makeStubs());
    toValidated(a, PATH, HASH);
    toValidated(a, PATH, HASH2); // edited -> re-validate
    assert.deepEqual(a.getSnapshot().context.validated, {
      path: PATH,
      hash: HASH2,
    });
    assert.equal(a.getSnapshot().can(beginRender(PATH, HASH)), false);
    assert.equal(a.getSnapshot().can(beginRender(PATH, HASH2)), true);
  },
);

await ok("re-validating a different path switches the validated source", () => {
  const a = makeActor(makeStubs());
  toValidated(a, PATH, HASH);
  a.send({ type: "BEGIN_VALIDATE" });
  a.send({
    type: "VALIDATE_DONE",
    path: "/tmp/other.mmd",
    hash: "x",
    ok: true,
    errors: [],
  });
  assert.deepEqual(a.getSnapshot().context.validated, {
    path: "/tmp/other.mmd",
    hash: "x",
  });
  assert.equal(a.getSnapshot().can(beginRender(PATH, HASH)), false);
});

await ok("failed re-validation clears the previous pass", () => {
  const a = makeActor(makeStubs());
  toValidated(a);
  a.send({ type: "BEGIN_VALIDATE" });
  a.send({
    type: "VALIDATE_DONE",
    path: PATH,
    hash: HASH2,
    ok: false,
    errors: ["broken again"],
  });
  assert.equal(a.getSnapshot().context.validated, null);
  assert.equal(a.getSnapshot().value, "drafting");
  assert.equal(a.getSnapshot().can(beginRender(PATH, HASH)), false);
});

// --- reset -----------------------------------------------------------------------

await ok(
  "RESET from validated with renders+embeds -> drafting, context cleared, limits kept",
  async () => {
    const stubs = makeStubs();
    const a = makeActor(stubs);
    toValidated(a);
    a.send(beginRender());
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    a.send(beginEmbed());
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    a.send({ type: "RESET" });
    assert.equal(a.getSnapshot().value, "drafting");
    const c = a.getSnapshot().context;
    assert.equal(c.validated, null);
    assert.equal(c.renders.length, 0);
    assert.equal(c.embeds.length, 0);
    assert.deepEqual(c.limits, LIMITS);
    assert.equal(a.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
    assert.equal(a.getSnapshot().can(beginRender()), false);
  },
);

// --- failureOf normalizer (service rejections -> machine routing data) -----------

await ok(
  "failureOf: shaped passthrough, missing cause -> diagram, non-shaped -> infra",
  () => {
    assert.deepEqual(failureOf({ errors: ["x"], cause: "infra" }), {
      errors: ["x"],
      cause: "infra",
    });
    assert.deepEqual(failureOf({ errors: ["x"], cause: "garbage" }), {
      errors: ["x"],
      cause: "diagram",
    });
    assert.deepEqual(failureOf({ errors: ["x"] }), {
      errors: ["x"],
      cause: "diagram",
    });
    assert.deepEqual(failureOf(new Error("boom")), {
      errors: ["boom"],
      cause: "infra",
    });
    assert.deepEqual(failureOf("str"), { errors: ["str"], cause: "infra" });
  },
);

// --- snapshot restore --------------------------------------------------------------

await ok(
  "persisted snapshot restores value, context, and legality",
  async () => {
    const stubs = makeStubs();
    const a = makeActor(stubs);
    toValidated(a);
    a.send(beginRender());
    await waitFor(a, (s) => s.matches("validated") || s.matches("drafting"));
    const persisted = a.getPersistedSnapshot();

    const b = createActor(makeMachine(stubs), {
      input: { limits: LIMITS },
      snapshot: persisted as never,
    });
    b.start();
    assert.equal(b.getSnapshot().value, "validated");
    assert.deepEqual(b.getSnapshot().context.validated, {
      path: PATH,
      hash: HASH,
    });
    assert.deepEqual(b.getSnapshot().context.renders, [OUT]);
    assert.equal(b.getSnapshot().can(beginEmbed()), true);
    assert.equal(b.getSnapshot().can(beginRender(PATH, HASH2)), false);
    assert.equal(b.getSnapshot().can(beginRender(PATH, HASH)), true);
    assert.equal(b.getSnapshot().can({ type: "BEGIN_VALIDATE" }), true);
  },
);

console.log(
  `\n${passed} tests passed${failed > 0 ? `, ${failed} failed` : ""}`,
);
if (failed > 0) process.exit(1);
