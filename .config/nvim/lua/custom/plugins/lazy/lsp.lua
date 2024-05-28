return {
	"neovim/nvim-lspconfig",
	dependencies = {
		"folke/neodev.nvim", -- neovim Lua deps
		"saadparwaiz1/cmp_luasnip",
		"j-hui/fidget.nvim",
		"williamboman/mason-lspconfig.nvim",
		"williamboman/mason.nvim",
		"hrsh7th/cmp-nvim-lsp",
	},
	config = function()
		require("custom.plugins.lsp")
	end,
}
