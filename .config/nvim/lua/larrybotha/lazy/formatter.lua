local function get_file()
	local util = require("formatter.util")
	return util.escape_path(util.get_current_buffer_file_path())
end

-- For configs for various formatters, see:
-- https://github.com/jose-elias-alvarez/null-ls.nvim/tree/main/lua/null-ls/builtins/formatting
local function getFormatters()
	local util = require("formatter.util")

	local custom_formatters = {
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
				args = { "--reformat", "--quiet", get_file(), "--", "-" },
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
			return function()
				local args = { util.escape_path(util.get_current_buffer_file_path()) }

				if parser then
					table.insert(args, "--parser=" .. parser)
				end

				return {
					exe = "prettierd",
					args = args,
					stdin = true,
				}
			end
		end,

		ruff = {
			format = function()
				return {
					exe = "ruff",
					args = {
						"format",
						"--no-cache",
						"--stdin-filename",
						get_file(),
						"-",
					},
					stdin = true,
				}
			end,

			lint = function()
				return {
					exe = "ruff",
					args = {
						"check",
						"--fix",
						"--select I", -- sort imports
						"--exit-zero",
						"--no-cache",
						"--stdin-filename",
						get_file(),
						"-",
					},
					stdin = true,
				}
			end,
		},

		python_autoimport = function()
			return {
				exe = "autoimport",
				args = {},
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

		-- sql formatter
		sleek = function()
			return {
				exe = "sleek",
				args = {},
				stdin = false,
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

	return custom_formatters
end

return {
	"mhartington/formatter.nvim",
	config = function()
		local formatter = require("formatter")
		local filetypes = require("formatter.filetypes")
		local formatters = require("formatter.defaults")
		local custom_formatters = getFormatters()

		formatter.setup({
			logging = true,
			log_level = vim.log.levels.WARN,

			filetype = {
				go = { custom_formatters.goimports, custom_formatters.gofmt },
				graphql = { custom_formatters.prettierd("graphql") },
				hcl = { custom_formatters.terraform },
				html = { custom_formatters.prettierd("html") },
				htmldjango = { custom_formatters.djlint },
				javascript = { custom_formatters.prettierd(), formatters.eslint_d },
				javascriptreact = { custom_formatters.prettierd(), formatters.eslint_d },
				json = {
					custom_formatters.prettierd("json"),
					custom_formatters.fixjson,
				},
				lua = { filetypes.lua.stylua },
				markdown = {
					custom_formatters.cbfmt,
					custom_formatters.doctoc,
					custom_formatters.prettierd(),
				},
				nginx = { custom_formatters.nginxbeautifier },
				org = { custom_formatters.cbfmt },
				packer = { custom_formatters.packer },
				python = {
					custom_formatters.python_autoimport,
					-- TODO: use unified command for linting and formatting when available:
					-- https://github.com/astral-sh/ruff/issues/8232
					custom_formatters.ruff.lint,
					-- NOTE: must come after linting to remove unused imports
					-- see https://docs.astral.sh/ruff/formatter/#sorting-imports
					custom_formatters.ruff.format,
				},
				rust = { filetypes.rust.rustfmt },
				sh = {
					custom_formatters.shfmt,
					custom_formatters.shellharden,
				},
				sql = { custom_formatters.sleek },
				svelte = { custom_formatters.prettierd("svelte"), formatters.eslint_d },
				svg = { custom_formatters.prettierd("html") },
				terraform = { custom_formatters.terraform },
				typescript = { custom_formatters.prettierd("typescript"), formatters.eslint_d },
				typescriptreact = { custom_formatters.prettierd(), formatters.eslint_d },
				vue = { custom_formatters.prettierd(), formatters.eslint_d },
				toml = { custom_formatters.taplo },
				yaml = { custom_formatters.prettierd("yaml") },
				zig = { formatters.zig },
			},

			["svx"] = { custom_formatters.prettierd() },
		})

		local au_group = vim.api.nvim_create_augroup("FormatAutogroup", { clear = true })

		-- format on save
		vim.api.nvim_create_autocmd("BufWritePost", {
			pattern = "*",
			group = au_group,
			-- silence errors raised by formatters that fail on syntax errors
			-- see https://github.com/mhartington/formatter.nvim/issues/100
			command = "silent FormatWrite",
			desc = "Format buffer on save",
		})
	end,
	enabled = true,
}
