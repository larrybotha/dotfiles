return {
	"mfussenegger/nvim-lint",
	event = "BufReadPre",
	config = function()
		require("custom.plugins.nvim-lint").setup()
	end,
}
