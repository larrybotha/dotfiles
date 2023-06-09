local util = require("formatter.util")

local function get_file()
	return util.escape_path(util.get_current_buffer_file_path())
end

-- For configs for various formatters, see:
-- https://github.com/jose-elias-alvarez/null-ls.nvim/tree/main/lua/null-ls/builtins/formatting
local M = {
	blackd_client = function()
		return {
			exe = "blackd-client",
			args = {},
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
				"--quiet",
				get_file(),
				"--",
				"-",
			},
			stdin = true,
		}
	end,

	-- https://github.com/thlorenz/doctoc
	-- Will only generate TOC in files containing:
	-- <!-- START doctoc -->
	-- <!-- END doctoc -->
	doctoc = function()
		return {
			exe = "doctoc",
			args = { "--update-only" },
			stdin = false,
		}
	end,

	fixjson = function()
		return {
			exe = "fixjson",
			args = {
				get_file(),
				"-",
			},
			stdin = true,
		}
	end,

	gofmt = function()
		return {
			exe = "gofmt",
			args = { get_file() },
			stdin = true,
		}
	end,

	goimports = function()
		return {
			exe = "goimports",
			args = { "-srcdir", util.get_cwd() },
			stdin = true,
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

	-- https://github.com/vasilevich/nginxbeautifier
	nginxbeautifier = function()
		return {
			exe = "nginxbeautifier",
			args = {},
			stdin = false,
		}
	end,

	packer = function()
		-- only process .pkr.hcl files
		if not util.get_current_buffer_file_name():match("%.pkr%.hcl$") == "special.lua" then
			return nil
		end

		return {
			exe = "packer",
			args = { "fmt", get_file(), "-" },
			stdin = true,
		}
	end,

	prettierd = function(parser)
		local args = { util.escape_path(util.get_current_buffer_file_path()) }

		if parser then
			table.insert(args, "--parser=" .. parser)
		end

		return function()
			return {
				exe = "prettierd",
				args = args,
				stdin = true,
			}
		end
	end,

	ruff = function()
		return {
			exe = "ruff",
			args = {
				"--fix",
				"--exit-zero",
				"--no-cache",
				"--stdin-filename",
				get_file(),
				"-",
			},
			stdin = true,
		}
	end,

	pyflyby_auto_import = function()
		return {
			exe = "tidy-imports",
			args = {
				"-n", -- do not format imports
				get_file(),
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

	shellharden = function()
		return {
			exe = "shellharden",
			args = { "--transform", get_file() },
			stdin = true,
		}
	end,

	sqlfluff = function()
		return {
			exe = "sqlfluff",
			args = {
				"fix",
				"--disable-progress-bar",
				get_file(),
				"-",
			},
			stdin = true,
		}
	end,

	taplo = function()
		return {
			exe = "taplo",
			args = {
				"format",
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
