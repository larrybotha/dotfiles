return {
	"rcarriga/nvim-dap-ui",
	dependencies = {
		-- see https://www.youtube.com/watch?v=lyNfnI-B640 for TJ's setup
		"leoluz/nvim-dap-go",
		"mfussenegger/nvim-dap",
		"mfussenegger/nvim-dap-python",
		"nvim-neotest/nvim-nio",
		"theHamsta/nvim-dap-virtual-text",
		"williamboman/mason.nvim",
	},
	config = function()
		require("custom.plugins.dap").setup()
	end,
}
