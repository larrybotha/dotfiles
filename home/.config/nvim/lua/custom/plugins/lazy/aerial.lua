return {
	"stevearc/aerial.nvim",
	-- TODO: remove this pinned commit once
	-- https://github.com/stevearc/aerial.nvim/issues/506 is resolved
	commit = "da0ceef62eb58b9bec1975017beb2f28c3b1e72c",
	dependencies = {
		"nvim-treesitter/nvim-treesitter",
		"nvim-tree/nvim-web-devicons",
	},
	config = function()
		local aerial = require("aerial")

		aerial.setup({
			open_automatic = function(bufnr)
				local pre_condition =
					-- minimum line count
					vim.api.nvim_buf_line_count(bufnr) > 80
					-- min symbol count
					and aerial.num_symbols(bufnr) > 4
					-- keep aerial closed when closed manually
					and not aerial.was_closed()
				local buf_condition = -- open if man page
					vim.api.nvim_get_option_value("filetype", { buf = bufnr }) == "man"
					-- open if in a help buffer
					or vim.api.nvim_get_option_value("filetype", { buf = bufnr }) == "help"
					-- open if in .venv dir
					or vim.fn.expand("%:p:h"):match("venv") ~= nil

				return pre_condition and buf_condition
			end,
		})

		-- Expand 'at' into 'AerialToggle' in the command line
		vim.cmd([[cabbrev at AerialToggle]])
	end,
}
