return {
	{
		"epwalsh/obsidian.nvim",
		name = "obsididan.nvim",
		dependencies = { "nvim-lua/plenary.nvim" },
		config = function()
			require("custom.plugins.obsidian")
		end,
	},
}
