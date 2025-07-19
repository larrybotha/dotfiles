local function get_file()
	local util = require("formatter.util")
	return util.escape_path(util.get_current_buffer_file_path())
end

-- For configs for various formatters, see:
-- https://github.com/jose-elias-alvarez/null-ls.nvim/tree/main/lua/null-ls/builtins/formatting
local function getFormatters()
	local util = require("formatter.util")

	local custom_formatters = {
		biome = {
			javascript = function()
				return {
					exe = "biome",
					args = {
						"check",
						"--write",
						"--formatter-enabled=true",
						"--organize-imports-enabled=true",
						"--skip-errors",
						"--stdin-file-path",
						get_file(),
					},
					stdin = true,
				}
			end,
		},

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

		golines = function()
			return {
				exe = "golines",
				args = {
					"--base-formatter",
					"gofumpt",
					"--max-len",
					"80",
					get_file(),
				},
				stdin = true,
			}
		end,

		-- https://github.com/kevingimbel/mktoc
		-- Will only generate TOC in files containing:
		-- <!-- BEGIN mktoc -->
		-- <!-- END mktoc -->
		mktoc = function()
			return {
				exe = "mktoc",
				args = { "-s", get_file() },
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

		-- TODO: determine why svelte files are not always formatted
		-- Appears to be something related to position of .prettierrc.cjs relative to
		-- file
		prettierd = function(parser)
			return function()
				local args = { util.escape_path(util.get_current_buffer_file_path()) }
				local defaultConfig =
					string.format("PRETTIERD_DEFAULT_CONFIG=%s", vim.fn.expand("~/.config/prettierd/.prettierrc.cjs"))
				local exe = defaultConfig .. " prettierd"

				if parser then
					table.insert(args, "--parser=" .. parser)
				end

				return { exe = exe, args = args, stdin = true }
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

local formatter = require("formatter")
local filetypes = require("formatter.filetypes")
local formatters = require("formatter.defaults")
local customFormatters = getFormatters()

local javascriptishFormatters = { customFormatters.biome.javascript }

formatter.setup({
	logging = true,
	log_level = vim.log.levels.WARN,

	filetype = {
		graphql = { customFormatters.prettierd("graphql") },
		go = { customFormatters.golines },
		gohtmltmpl = { customFormatters.golines },
		gotmpl = { customFormatters.golines },
		hcl = { customFormatters.terraform },
		html = { customFormatters.prettierd("html") }, -- replace with biome once supported
		htmldjango = { customFormatters.djlint },
		javascript = javascriptishFormatters,
		javascriptreact = javascriptishFormatters,
		json = javascriptishFormatters,
		jsonc = javascriptishFormatters,
		lua = { filetypes.lua.stylua },
		markdown = {
			customFormatters.cbfmt,
			customFormatters.mktoc,
			customFormatters.prettierd(), -- replace with biome once supported
		},
		nginx = { customFormatters.nginxbeautifier },
		nix = { formatters.alejandra },
		org = { customFormatters.cbfmt },
		packer = { customFormatters.packer },
		python = {
			customFormatters.python_autoimport,
			-- TODO: use unified command for linting and formatting when available:
			-- https://github.com/astral-sh/ruff/issues/8232
			customFormatters.ruff.lint,
			-- NOTE: must come after linting to remove unused imports
			-- see https://docs.astral.sh/ruff/formatter/#sorting-imports
			customFormatters.ruff.format,
		},
		rust = { filetypes.rust.rustfmt },
		sh = {
			customFormatters.shfmt,
			customFormatters.shellharden,
		},
		sql = { customFormatters.sleek },
		svelte = {
			customFormatters.prettierd("svelte"),
			--formatters.eslint_d
		}, -- replace with biome once supported
		svg = { customFormatters.prettierd("html") }, -- replace with biome once supported
		terraform = { customFormatters.terraform },
		typescript = javascriptishFormatters,
		typescriptreact = javascriptishFormatters,
		vue = { customFormatters.prettierd(), formatters.eslint_d }, -- replace with biome once supported
		toml = { customFormatters.taplo },
		yaml = { customFormatters.prettierd("yaml") }, -- replace with biome once supported
		zig = { formatters.zig },
	},

	["svx"] = { customFormatters.prettierd() }, -- replace with biome once supported
})

local au_group = vim.api.nvim_create_augroup("FormatAutogroup", { clear = true })

-- format on save
vim.api.nvim_create_autocmd("BufWritePost", {
	pattern = "*",
	group = au_group,
	-- silence errors raised by formatters that fail on syntax errors
	-- see https://github.com/mhartington/formatter.nvim/issues/100
	--command = "silent FormatWrite",
	--command = "silent FormatWrite",
	command = "FormatWrite",
	desc = "Format buffer on save",
})
