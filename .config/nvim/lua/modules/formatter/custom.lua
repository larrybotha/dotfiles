local util = require("formatter.util")

local function get_file()
	return util.escape_path(util.get_current_buffer_file_path())
end

-- For configs for various formatters, see:
-- https://github.com/jose-elias-alvarez/null-ls.nvim/tree/main/lua/null-ls/builtins/formatting
local M = {
	autoimport = function()
		return {
			exe = "autoimport",
			args = {
				get_file(),
				"-",
			},
			stdin = true,
		}
	end,

	black = function()
		return {
			exe = "black",
			args = {
				"--stdin-filename",
				get_file(),
				"--quiet",
				"-",
			},
			stdin = true,
		}
	end,

	cbfmt = function()
		return {
			exe = "cbfmt",
			args = {
				"--stdin-filepath",
				get_file(),
				"--best-effort",
			},
			stdin = true,
		}
	end,

	djlint = function()
		return {
			exe = "djlint",
			args = {
				"--reformat",
				get_file(),
				"--",
				"-",
			},
			stdin = true,
		}
	end,

	fixjson = function()
		return {
			exe = "fixjson",
			args = {
				get_file(),
				"-",
			},
			to_stdin = true,
		}
	end,

	isort = function()
		return {
			exe = "isort",
			args = {
				"--stdout",
				"--filename",
				get_file(),
				"-",
			},
			stdin = true,
		}
	end,

	shfmt = function()
		return {
			exe = "shfmt",
			args = {
				"-filename",
				get_file(),
				"-",
			},
			stdin = true,
		}
	end,

	sqlfluff = function()
		return {
			command = "sqlfluff",
			args = {
				"fix",
				"--disable-progress-bar",
				get_file(),
				"-",
			},
			stdin = true,
		}
	end,

	terraform = function()
		return {
			exe = "terraform",
			args = {
				"fmt",
				"-",
			},
			stdin = true,
		}
	end,
}

return M
