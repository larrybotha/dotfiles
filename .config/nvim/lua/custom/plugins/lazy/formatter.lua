return {
	"mhartington/formatter.nvim",
	config = function()
		require("custom.plugins.formatter").setup()
	end,
	enabled = true,
}
