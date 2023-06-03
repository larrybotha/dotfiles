local highlight = {
	"CursorColumn",
	"Whitespace",
}

require("ibl").setup({
	exclude = {
		buftypes = { "terminal" },
	},
	indent = { highlight = highlight, char = "" },
	whitespace = {
		highlight = highlight,
		remove_blankline_trail = false,
	},
	scope = { enabled = false },
})
