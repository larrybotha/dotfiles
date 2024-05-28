require("luasnip.session.snippet_collection").clear_snippets("htmldjango")

local luasnip = require("luasnip")
local s = luasnip.snippet
local i = luasnip.insert_node

local fmt = require("luasnip.extras.fmt").fmt

luasnip.add_snippets("htmldjango", {
	s("elif", fmt("{{% elif {} %}}\n{}\n", { i(1), i(0) })),
	s("for", fmt("{{% for {} in {} %}}\n{}\n{{% empty %}}\n{}\n{{% endfor %}}", { i(1), i(2), i(3), i(0) })),
	s("if", fmt("{{% if {} %}}\n{}\n{{% endif %}}", { i(1), i(0) })),
	s("spaceless", fmt("{{% spaceless %}}\n{}\n{{% endspaceless %}}", { i(0) })),
})
