return {
	"hrsh7th/nvim-cmp",
	dependencies = {
		"kristijanhusak/vim-dadbod-completion",
		"L3MON4D3/LuaSnip", -- see https://www.youtube.com/watch?v=22mrSjknDHI for snippet configs
		"hrsh7th/cmp-buffer",
		"hrsh7th/cmp-cmdline",
		"hrsh7th/cmp-nvim-lsp",
		"hrsh7th/cmp-nvim-lsp-document-symbol",
		"hrsh7th/cmp-nvim-lsp-signature-help",
		"hrsh7th/cmp-nvim-lua",
		"hrsh7th/cmp-path",
		{
			"folke/lazydev.nvim",
			ft = "lua", -- only load on lua files
			opts = {},
		},
		{ "Bilal2453/luvit-meta", lazy = true }, -- add `vim.uv` typings
	},
	config = function()
		require("custom.plugins.cmp")
	end,
}
