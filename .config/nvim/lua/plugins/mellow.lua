M = {}

M.lazy_config = {
	"kvrohit/mellow.nvim",
	lazy = false,
	priority = 1000,
	config = function()
		vim.cmd.colorscheme("mellow")
	end,
}

return M
