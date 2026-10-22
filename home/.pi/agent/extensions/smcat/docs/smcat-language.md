# smcat language reference

Language facts for `state-machine-cat@15.0.10`, the version
`executors/Dockerfile` installs.

## Statements

- Statements end with `;`.
- `#` starts a comment to end of line.
- Both `=>` and `->` are transition operators.
- Declarations are separated by `,`. All state declarations form a single
  comma-separated statement; a second declaration statement is a syntax
  error.
- State declarations must precede transition statements. A declaration after
  a transition is a syntax error.

## Transitions

Grammar shapes (placeholders, not literal input):

```text
from => to;
from => to: label;
from => to [attributes];
from => to [attributes]: label;
```

Labels follow the UML convention `from => to: event [conditions]/ actions`.
smcat records the event/condition/action split in its internal model but does
not validate the notation.

## State declarations

All declarations form one comma-separated statement terminated by `;`.

```smcat
doing:
  entry/ make a feature branch
  exit/ deploy code
  ...,
on [label="Lamp aan"],
off [label="Lamp uit"],
eat   [color="#008800"],
sleep [color="blue" active],
initialized [color="red" type=regular],
meow  [class="dismissed"];
```

Attributes:

| Attribute | Applies to | Values |
| --- | --- | --- |
| `color` | state, transition | color string, e.g. `"blue"`, `"#008800"` |
| `width` | transition | positive number, e.g. `3.5` |
| `active` | state | flag, no value |
| `type` | state, transition | see state types / `internal`\|`external` |
| `class` | state, transition | alpha-numerics, dashes, underscores, spaces |
| `label` | state | quoted display name |

## Transition attributes

Transition attributes go **before** the `:` label:

```smcat

sleep -> meow  [color="red"]            : wake up;
eat   -> sleep [color="blue" width=3.5] : belly full;
playing => playing [type=internal]      : ingest drink;
a => b [class="a bunch of classes"];
```

## State types

State type is derived from the name: a name containing `initial`, `final` or
`history` is rendered as the corresponding UML pseudo state. Override with
`type=`.

| `type` | `type` |
| --- | --- |
| `regular` | `fork` |
| `initial` | `join` |
| `final` | `forkjoin` |
| `history` | `junction` |
| `deephistory` | `parallel` |
| `choice` | `terminate` |

Transition `type` is `external` (default) or `internal`.

## Naming

Names containing `;`, `,`, `{`, `[` or spaces are quoted: `"a state"`.
Activities and labels allow spaces; labels also allow `,`.

When `initial` or `final` appears anywhere in a state's name, smcat treats it
as the UML pseudo state — they are name-derived types, not modifiers.

## Verified example

```smcat

# declarations first
eat   [color="#008800"],
sleep [color="blue" active],
meow  [color="red"],
play  [color="purple"];

# then transitions
initial => sleep;
sleep -> meow  [color="red"]              : wake up;
meow  -> eat   [color="#008800"]         : human gives food;
meow  -> play  [color="purple"]          : human gives toy;
play  -> sleep [color="blue"]            : tired or bored;
eat   -> sleep [color="blue" width=3.5]  : belly full;
```

## Render-time, not language

- `direction` (`top-down|bottom-top|left-right|right-left`) selects layout;
  it is not part of the source or its hash.
- `svg`/`dot` are pure-node outputs; `png`/`pdf` require native Graphviz
  (present in the image).
- `color`, `width` and `class` are experimental upstream; renderer support
  varies by output type. `class` only takes effect where a stylesheet
  defining the classes is present.
