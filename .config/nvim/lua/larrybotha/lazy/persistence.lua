return {
	{
		"folke/persistence.nvim",
		config = function()
			require("persistence").setup()

			vim.api.nvim_create_user_command("DoTheSession", function()
				require("persistence").load()
			end, {})
		end,
	},
}
