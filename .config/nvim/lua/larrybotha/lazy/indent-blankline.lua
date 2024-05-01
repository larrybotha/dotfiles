local highlight = {
	"CursorColumn",
	"Whitespace",
}

return {
	{
		"lukas-reineke/indent-blankline.nvim",
		name = "indent-blankline",
		main = "ibl",
		opts = {
			exclude = {
				buftypes = { "terminal" },
			},
			indent = { highlight = highlight, char = "" },
			whitespace = {
				highlight = highlight,
				remove_blankline_trail = false,
			},
			scope = { enabled = false },
		},
	},
}
