return {
	{
		"mellow-theme/mellow.nvim",
		name = "mellow",
		init = function()
			require("custom.plugins.mellow")
		end,
	},
	{
		"norcalli/nvim-colorizer.lua",
		config = function()
			require("colorizer").setup()
		end,
	},
}
