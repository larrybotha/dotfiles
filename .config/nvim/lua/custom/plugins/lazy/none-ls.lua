return {
	"nvimtools/none-ls.nvim", -- TODO: - consider nvim-lint
	config = function()
		require("custom.plugins.none-ls").setup()
	end,
}
