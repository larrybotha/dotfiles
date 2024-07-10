return {
	"nvimtools/none-ls.nvim", -- TODO: - consider nvim-lint
	event = "VeryLazy",
	config = function()
		require("custom.plugins.none-ls").setup()
	end,
}
