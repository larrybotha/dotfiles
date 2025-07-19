return {
	"neovim/nvim-lspconfig",
	dependencies = {
		{ "WhoIsSethDaniel/mason-tool-installer.nvim", lazy = true },
		{ "b0o/schemastore.nvim", lazy = true },
		{ "saghen/blink.cmp", lazy = true },
		{ "j-hui/fidget.nvim", lazy = true },
		{ "williamboman/mason-lspconfig.nvim", lazy = true },
		{ "williamboman/mason.nvim", lazy = true },
	},
	event = "VeryLazy",
	config = function()
		require("custom.plugins.lsp")
	end,
}
