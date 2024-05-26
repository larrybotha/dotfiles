return {
	"neovim/nvim-lspconfig",
	dependencies = {
		"folke/neodev.nvim", -- neovim Lua deps
		"saadparwaiz1/cmp_luasnip",
		"j-hui/fidget.nvim",
		"williamboman/mason-lspconfig.nvim",
		"williamboman/mason.nvim",
		-- TODO: move cmp configs to completion.lua
		"L3MON4D3/LuaSnip", -- see https://www.youtube.com/watch?v=22mrSjknDHI for snippet configs
		"hrsh7th/cmp-buffer",
		"hrsh7th/cmp-cmdline",
		"hrsh7th/cmp-nvim-lsp",
		"hrsh7th/cmp-nvim-lsp-document-symbol",
		"hrsh7th/cmp-nvim-lsp-signature-help",
		"hrsh7th/cmp-nvim-lua",
		"hrsh7th/cmp-path",
		"hrsh7th/nvim-cmp",
	},
	config = function()
		require("custom.plugins.lsp").setup()
	end,
}
