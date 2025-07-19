return {
	{
		"epwalsh/obsidian.nvim",
		name = "obsididan.nvim",
		event = "VeryLazy",
		dependencies = { "nvim-lua/plenary.nvim" },
		config = function()
			require("custom.plugins.obsidian")
		end,
	},
}
