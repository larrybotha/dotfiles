require("luasnip.session.snippet_collection").clear_snippets("htmldjango")

local luasnip = require("luasnip")
local s = luasnip.snippet
local i = luasnip.insert_node
local fmt = require("luasnip.extras.fmt").fmt

return {
	s({ filetype = "htmldjango", trig = "comment" }, fmt("{{% comment %}}\n{}\n{{% endcomment %}}", { i(0) })),
	s(
		{ filetype = "htmldjango", trig = "component" },
		fmt("{{% component {} %}}\n{}\n{{% endcomponent %}}", { i(1), i(0) })
	),
	s({ filetype = "htmldjango", trig = "djlint" }, fmt("{{# djlint:off #}}\n{}\n{{# djlint:on #}}", { i(0) })),
	s({ filetype = "htmldjango", trig = "elif" }, fmt("{{% elif {} %}}\n{}\n", { i(1), i(0) })),
	s(
		{ filetype = "htmldjango", trig = "for" },
		fmt("{{% for {} in {} %}}\n{}\n{{% empty %}}\n{}\n{{% endfor %}}", { i(1), i(2), i(3), i(0) })
	),
	s(
		{ filetype = "htmldjango", trig = "if" },
		fmt("{{% if {} %}}\n{}\n{{% else %}}\n{}\n{{% endif %}}", { i(1), i(2), i(0) })
	),
	s({ filetype = "htmldjango", trig = "if" }, fmt("{{% if {} %}}\n{}\n{{% endif %}}", { i(1), i(0) })),
	s({ filetype = "htmldjango", trig = "include" }, fmt('{{% include "{}"{} %}}', { i(1), i(0) })),
	s({ filetype = "htmldjango", trig = "load" }, fmt("{{% load {} %}}", { i(0) })),
	s({ filetype = "htmldjango", trig = "spaceless" }, fmt("{{% spaceless %}}\n{}\n{{% endspaceless %}}", { i(0) })),
}
