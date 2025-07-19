return {
	{
		"stevearc/conform.nvim",
		log_level = vim.log.levels.ERROR,

		config = function()
			require("custom.plugins.conform").setup()
		end,
		enabled = false,
	},
}
