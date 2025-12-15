return {
	"Davidyz/VectorCode",
	version = "*",
	build = "uv tool upgrade vectorcode",
	dependencies = { "nvim-lua/plenary.nvim" },
	cond = function()
		return vim.fn.executable("vectorcode") == 1
	end,
	config = function()
		require("vectorcode").setup(
			---@type VectorCode.Opts
			{
				cli_cmds = {
					vectorcode = "vectorcode",
				},
				---@type VectorCode.RegisterOpts
				async_opts = {
					debounce = 10,
					events = { "BufWritePost", "InsertEnter", "BufReadPost" },
					exclude_this = true,
					n_query = 1,
					notify = false,
					query_cb = require("vectorcode.utils").make_surrounding_lines_cb(-1),
					-- use `:VectorCode register` to register specific files for indexing
					-- base on the events in this config
					run_on_register = false,
				},
				async_backend = "default", -- default|lsp
				exclude_this = true,
				n_query = 1,
				notify = true,
				timeout_ms = 5000,
				on_setup = {
					update = true,
					lsp = false,
				},
				sync_log_env_var = false,
			}
		)
	end,
}
