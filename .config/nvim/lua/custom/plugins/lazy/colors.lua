local function doTheColours()
	-- Define custom cursor color highlights
	local cursorline_opts = { bold = true, bg = "black" }
	vim.api.nvim_set_hl(0, "CursorLine", cursorline_opts)
	vim.api.nvim_set_hl(0, "CursorColumn", cursorline_opts)

	-- Highlight trailing white space
	local errorHl = vim.api.nvim_get_hl(0, { name = "Error" })
	vim.api.nvim_set_hl(0, "ExtraWhiteSpace", { bg = errorHl.fg })
	vim.cmd([[match ExtraWhitespace /\s\+$/]])

	vim.api.nvim_set_hl(0, "NvimInternalError", { reverse = true })
end

return {
	{
		"mellow-theme/mellow.nvim",
		name = "mellow",
		lazy = false,
		priority = 1000,
		init = function()
			local colors = require("mellow.colors").dark

			vim.cmd.colorscheme("mellow")

			local highlights = {
				["TelescopeBorder"] = { link = "FloatBorder" },
				["TelescopeNormal"] = { link = "Normal" },
				["TelescopeTitle"] = { fg = colors.magenta },
				["TelescopePreviewTitle"] = { link = "TelescopeTitle" },
				["TelescopeResultsTitle"] = { link = "TelescopeTitle" },
				["TelescopePromptTitle"] = { link = "TelescopeTitle" },
				["TelescopePromptBorder"] = { fg = colors.gray01, bg = colors.gray01 },
				["TelescopePromptNormal"] = { fg = colors.gray06, bg = colors.gray01 },
				["TelescopePromptCounter"] = { fg = colors.gray04, bg = colors.gray01 },
				["TelescopeMatching"] = { link = "Search" },
			}

			for k, v in pairs(highlights) do
				vim.api.nvim_set_hl(0, k, v)
			end

			doTheColours()
		end,
	},
	{
		"norcalli/nvim-colorizer.lua",
		event = "VeryLazy",
		opts = {},
	},
}
