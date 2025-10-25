local M = {}
local prop = "_conform_disable_autoformat"

local function formatOnSave(bufnr)
	if vim.g[prop] or vim.b[bufnr][prop] then
		return
	end

	return { timeout_ms = 1000 }
end

local function disableFormatting(args)
	if args.bang then
		-- disable only for buffer
		vim.b[prop] = true
	else
		vim.g[prop] = true
	end
end

local function enableFormatting()
	vim.b[prop] = false
	vim.g[prop] = false
end

local function extendFormatters(conform)
	local formatters = conform.formatters
	local util = require("conform.util")

	formatters.custom_golines = function()
		return {
			command = "golines",
			args = {
				"--base-formatter",
				"gofumpt",
				"--max-len",
				"80",
			},
		}
	end

	-- https://github.com/thlorenz/doctoc
	formatters.custom_doctoc = function()
		-- Will only generate TOC in files containing:
		-- <!-- START doctoc -->
		-- <!-- END doctoc -->
		return {
			command = "doctoc",
			args = { "--update-only" },
			stdin = false,
		}
	end

	-- https://github.com/vasilevich/nginxbeautifier
	formatters.custom_nginxbeautifier = function()
		return {
			command = "nginxbeautifier",
			args = {},
			stdin = false,
		}
	end

	formatters.custom_packer = function()
		return {
			condition = function(self, ctx)
				-- only if ends in .pkr.hcl
				return ctx.filename:match("%.pkr%.hcl$") == ".pkr.hcl"
			end,
			command = "packer",
			args = { "fmt", "-" },
			stdin = true,
		}
	end

	-- https://pypi.org/project/autoimport/
	formatters.custom_python_autoimport = function()
		return {
			command = "autoimport",
			args = { "$FILENAME" },
			stdin = false, -- file updated in-place
		}
	end

	formatters.custom_ruff_lint = function()
		return {
			command = "ruff",
			args = {
				"check",
				"--fix",
				"--select",
				"I", -- sort imports
				"--exit-zero",
				"--no-cache",
				"--stdin-filename",
				"$FILENAME",
				"-",
			},
			stdin = true,
		}
	end

	formatters.custom_ruff_format = function()
		return {
			command = "ruff",
			args = {
				"format",
				"--no-cache",
				"--stdin-filename",
				"$FILENAME",
				"-",
			},
			stdin = true,
		}
	end
end

M.setup = function()
	local conform = require("conform")

	extendFormatters(conform)

	conform.setup({
		format_on_save = formatOnSave,

		formatters_by_ft = {
			c = { "clang_format" },
			go = { "custom_golines" },
			gohtmltmpl = { "custom_golines" },
			gotmpl = { "custom_golines" },
			hcl = { "custom_packer", lsp_format = "prefer" },
			html = { "prettierd" },
			htmldjango = { "djlint" },
			javascript = {
				"prettierd",
				"biome-organize-imports",
				"biome",
			},
			javascriptreact = { "biome-organize-imports", "biome" },
			json = { "biome" },
			jsonc = { "biome" },
			just = { "just" },
			lua = { "stylua" },
			markdown = { "cbfmt", "custom_doctoc" },
			nginx = { "custom_nginxbeautifier" },
			org = { "cbfmt", "custom_doctoc", "prettierd" }, -- format code within markdown code fence blocks
			packer = { "custom_packer" },
			python = {
				"custom_python_autoimport",
				"custom_ruff_lint",
				"custom_ruff_format",
			}, -- ruff_lint must be run before formatter
			rust = { "rustfmt" },
			sh = { "shfmt", "shellharden" },
			scss = { lsp_format = "never" },
			sql = { "sleek" },
			svelte = { "prettierd", "eslint_d" },
			svg = { "prettierd" },
			svx = { "prettierd" },
			terraform = { "terraform_fmt" },
			toml = { "taplo" },
			typescript = { "biome-organize-imports", "biome" },
			typescriptreact = { "biome-organize-imports", "biome" },
			yaml = { "prettierd" },
			zig = { "zigfmt" },
		},
	})

	vim.api.nvim_create_user_command("FormatDisable", disableFormatting, {
		desc = "Disable autoformat-on-save",
		bang = true,
	})

	vim.api.nvim_create_user_command("FormatEnable", enableFormatting, {
		desc = "Re-enable autoformat-on-save",
	})
end

return M
