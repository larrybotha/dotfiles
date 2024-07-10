return {
	"mhartington/formatter.nvim",
	event = "VeryLazy",
	config = function()
		require("custom.plugins.formatter")
	end,
	enabled = true,
}
