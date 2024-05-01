local prop = "_conform_disable_autoformat"

local function formatOnSave(bufnr)
	if vim.g[prop] or vim.b[bufnr][prop] then
		return
	end

	return { timeout_ms = 500, lsp_fallback = true }
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

	-- https://github.com/nrempel/sleek
	formatters.custom_sleek = function()
		return {
			command = "sleek",
			args = {},
			stdin = false,
		}
	end

	formatters.prettierd = function()
		return {
			args = function(_, context)
				local extension = string.match(context.filename, "%.([^%.]+)$")
				local parser_by_ext = {
					svg = "html",
					svelte = "html", -- TODO: determine why 'svelte' parser doesn't work
				}
				local parser = parser_by_ext[extension]
				local args = { "$FILENAME" }

				if parser then
					table.insert(args, "--parser=" .. parser)
				end

				print(vim.inspect(args))

				return args
			end,
			inherit = false,
			stdin = true,
			command = "prettierd",
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

return {
	{
		"stevearc/conform.nvim",
		log_level = vim.log.levels.ERROR,

		config = function()
			local conform = require("conform")

			extendFormatters(conform)

			conform.setup({
				format_on_save = formatOnSave,

				formatters_by_ft = {
					hcl = { "terraform_fmt" },
					html = { "prettierd" },
					htmldjango = { "djlint" },
					javascript = { "prettierd", "eslint_d" },
					javascriptreact = { "prettierd", "eslint_d" },
					json = { "prettierd", "fixjson" },
					just = { "justfile" },
					lua = { "stylua" },
					markdown = { "cbfmt" },
					nginx = { "custom_nginxbeautifier" },
					org = { "cbfmt", "custom_doctoc", "prettierd" }, -- format code within markdown code fence blocks
					packer = { "packer_fmt" },
					python = {
						"custom_python_autoimport",
						"custom_ruff_lint",
						"custom_ruff_format",
					}, -- ruff_lint must be run before formatter
					rust = { "rustfmt" },
					sh = { "shfmt", "shellharden" },
					sql = { "custom_sleek" },
					svelte = { "prettierd", "eslint_d" },
					svg = { "prettierd" },
					svx = { "prettierd" },
					terraform = { "terraform_fmt" },
					toml = { "taplo" },
					typescript = { "prettierd", "eslint_d" },
					typescriptreact = { "prettierd", "eslint_d" },
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
		end,
		enabled = false,
	},
}
