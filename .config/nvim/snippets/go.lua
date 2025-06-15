require("luasnip.session.snippet_collection").clear_snippets("svelte")

local luasnip = require("luasnip")
local s = luasnip.snippet
local i = luasnip.insert_node
local t = luasnip.text_node

local fmt = require("luasnip.extras.fmt").fmt

return {
	s("trig", t("loaded")),

	s({ filetype = "go", trig = "iferr" }, fmt("if err != nil {{\n\treturn {}\n}}", { i(0) })),
	s(
		{ filetype = "go", trig = "frange" },
		fmt("for {2}, {1} := range {3} {{\n\t{4}\n}}", { i(2, "v"), i(1, "i"), i(3), i(4) })
	),
}
