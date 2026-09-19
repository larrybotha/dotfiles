return {
	"cenk1cenk2/jq.nvim",
	dependencies = {
		"nvim-lua/plenary.nvim",
		-- https://github.com/MunifTanjim/nui.nvim
		"MunifTanjim/nui.nvim",
		-- https://github.com/grapp-dev/nui-components.nvim
		"grapp-dev/nui-components.nvim",
	},
	config = function()
		require("jq").setup({})

		vim.keymap.set("n", "<leader>jq", function()
			require("jq").run()
		end)

		vim.keymap.set("v", "<leader>jq", function()
			require("jq").run_visual()
		end)
	end,
}
