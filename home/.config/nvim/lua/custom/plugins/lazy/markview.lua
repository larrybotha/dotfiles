return {
	"OXY2DEV/markview.nvim",
	dependencies = { "saghen/blink.cmp" },
	lazy = false,
	config = function()
		require("markview").setup({

			preview = {
				filetypes = { "markdown", "codecompanion" },
				icon_provider = "devicons",

				ignore_buftypes = {},
			},
		})
	end,
}
