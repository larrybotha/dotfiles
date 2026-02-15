return {
	"olimorris/codecompanion.nvim",
	dependencies = {
		"Davidyz/VectorCode",
		"nvim-lua/plenary.nvim",
		"nvim-treesitter/nvim-treesitter",
	},
	config = function()
		require("custom.plugins.codecompanion")
	end,
	event = "VeryLazy",
	enabled = false,
}
