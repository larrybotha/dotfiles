local neogen = require("neogen")

neogen.setup({
	enabled = true,
	languages = {
		python = { template = { annotation_convention = "numpydoc" } },
	},
})

local opts = { noremap = true, silent = true }
vim.api.nvim_set_keymap("n", "<C-_>", ":lua require('neogen').generate()<CR>", opts)
