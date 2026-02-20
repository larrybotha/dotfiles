require("luasnip.session.snippet_collection").clear_snippets("markdown")

local luasnip = require("luasnip")
local s = luasnip.snippet
local i = luasnip.insert_node
local f = luasnip.function_node

local fmt = require("luasnip.extras.fmt").fmt

local function get_current_date()
	return os.date("%Y-%m-%d")
end

luasnip.add_snippets("markdown", {
	s(
		"notellmsuccess",
		fmt(
			[[
Date: {}
Tags: #llm-prompt-pattern #llm-success #llm-{}
## What I Tried
{}
## Why It Worked
{}
## Example
{}
## When to Use Again
{}
  ]],
			{ f(get_current_date), i(1, "[tag]"), i(2), i(3), i(4), i(0) }
		)
	),

	s(
		"notellmmistake",
		fmt(
			[[
Date: {}
Tags: #llm-mistake #llm-lesson #llm-{}
## What Went Wrong
{}
## Why It Happened
{}
## How I Fixed It
{}
## What I'll Do Differently
{}
  ]],
			{ f(get_current_date), i(1, "[tag]"), i(2), i(3), i(4), i(0) }
		)
	),

	s(
		"notellmwin",
		fmt(
			[[
Date: {}
Tags: #llm-win #llm-productivity #llm-{}
## The Task
{}
## Traditional Approach Time
{}
## AI-Assisted Time
{}
## What Made It Fast
{}
## Reusable Pattern
{}
  ]],
			{ f(get_current_date), i(1, "[tag]"), i(2), i(3), i(4), i(5), i(0) }
		)
	),

	s(
		"notellmdiscovery",
		fmt(
			[[
Date: {}
Tags: #llm-tool-feature #llm-discovery #llm-{}
## Feature Found
{}
## How to Use It
{}
## Use Cases
{}
## Impact
{}
  ]],
			{ f(get_current_date), i(1, "[tag]"), i(2), i(3), i(4), i(0) }
		)
	),
})
