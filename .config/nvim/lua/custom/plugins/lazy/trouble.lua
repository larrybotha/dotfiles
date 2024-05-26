return {
	"folke/trouble.nvim",

	config = function()
		require("trouble").setup()

		local opts = {
			silent = true,
			noremap = true,
		}

		vim.keymap.set("n", "<leader>xx", "<cmd>TroubleToggle<cr>", opts)
		vim.keymap.set("n", "<leader>xw", "<cmd>TroubleToggle workspace_diagnostics<cr>", opts)
		vim.keymap.set("n", "<leader>xd", "<cmd>TroubleToggle document_diagnostics<cr>", opts)
		vim.keymap.set("n", "<leader>xl", "<cmd>TroubleToggle loclist<cr>", opts)
		vim.keymap.set("n", "<leader>xq", "<cmd>TroubleToggle quickfix<cr>", opts)
	end,
}
