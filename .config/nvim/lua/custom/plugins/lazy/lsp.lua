return {
	"neovim/nvim-lspconfig",
	dependencies = {
		"WhoIsSethDaniel/mason-tool-installer.nvim",
		"b0o/schemastore.nvim",
		"hrsh7th/cmp-nvim-lsp",
		"j-hui/fidget.nvim",
		"saadparwaiz1/cmp_luasnip",
		"williamboman/mason-lspconfig.nvim",
		"williamboman/mason.nvim",
	},
	config = function()
		require("custom.plugins.lsp")
	end,
}
