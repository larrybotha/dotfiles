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
					debounce = 100, -- Debounce time in milliseconds to avoid excessive updates
					events = { "BufWritePost", "InsertLeave", "BufReadPost" }, -- Events that trigger automatic file indexing
					exclude_this = true, -- Exclude current buffer from automatic indexing
					n_query = 1, -- Number of queries to send for each indexing operation
					notify = true, -- Show notifications when indexing operations occur
					query_cb = require("vectorcode.utils").make_surrounding_lines_cb(-1), -- Use surrounding lines as context for better indexing
					-- Don't automatically index when files are manually registered
					-- Use `:VectorCode register` to register specific files for indexing
					run_on_register = false,
				},
				async_backend = "default", -- Backend to use for async operations (default or lsp)
				exclude_this = true, -- Exclude current buffer from operations
				n_query = 1, -- Number of queries to send for each operation
				notify = true, -- Show notifications for operations
				timeout_ms = 5000, -- Timeout in milliseconds for operations
				on_setup = {
					update = true, -- Update VectorCode on setup
					lsp = false, -- Don't enable LSP integration
				},
				sync_log_env_var = false, -- Don't sync environment variables for logging
			}
		)
	end,
}
