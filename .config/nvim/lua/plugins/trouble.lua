local trouble = require("trouble")

trouble.setup()

local options = {
	silent = true,
	noremap = true,
}

vim.keymap.set("n", "<leader>xx", "<cmd>TroubleToggle<cr>", options)
vim.keymap.set("n", "<leader>xw", "<cmd>TroubleToggle workspace_diagnostics<cr>", options)
vim.keymap.set("n", "<leader>xd", "<cmd>TroubleToggle document_diagnostics<cr>", options)
vim.keymap.set("n", "<leader>xl", "<cmd>TroubleToggle loclist<cr>", options)
vim.keymap.set("n", "<leader>xq", "<cmd>TroubleToggle quickfix<cr>", options)
