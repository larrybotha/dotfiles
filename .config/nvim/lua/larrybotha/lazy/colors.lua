return {
	{
		"mellow-theme/mellow.nvim",
		name = "mellow",
		init = function()
			--require("mellow").setup()
			vim.cmd.colorscheme("mellow")
		end,
	},
	{
		"norcalli/nvim-colorizer.lua",
		config = function()
			require("colorizer").setup()
		end,
	},
}
