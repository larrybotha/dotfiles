require("luasnip.session.snippet_collection").clear_snippets("svelte")

local luasnip = require("luasnip")
local s = luasnip.snippet
local i = luasnip.insert_node

local fmt = require("luasnip.extras.fmt").fmt

return {
	s({ filetype = "svelte", trig = "if" }, fmt("{#if []}\n\t[]\n{/if}", { i(1), i(0) }, { delimiters = "[]" })),
	s({ filetype = "svelte", trig = "else" }, fmt("{:else}\n\t[]", { i(0) }, { delimiters = "[]" })),
	s({ filetype = "svelte", trig = "elif" }, fmt("{:else if}\n\t[]", { i(0) }, { delimiters = "[]" })),

	s(
		{ filetype = "svelte", trig = "each" },
		fmt("{#each [] as []}\n\t[]\n{/each}", { i(1, "x"), i(2, "xs"), i(0) }, { delimiters = "[]" })
	),
	s(
		{ filetype = "svelte", trig = "each" },
		fmt(
			"{#each [] as [], i ([])}\n\t[]\n{/each}",
			{ i(1, "x"), i(2, "xs"), i(3, "identifier"), i(0) },
			{ delimiters = "[]" }
		)
	),
}
