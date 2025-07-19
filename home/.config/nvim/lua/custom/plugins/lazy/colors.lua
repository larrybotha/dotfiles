return {
	{
		"mellow-theme/mellow.nvim",
		name = "mellow",
		event = "VeryLazy",
		priority = 1000,
		init = function()
			vim.cmd.colorscheme("mellow")

			local colors = require("mellow.colors").dark
			local highlights = {
				["TelescopeBorder"] = { link = "FloatBorder" },
				["TelescopeMatching"] = { link = "Search" },
				["TelescopeNormal"] = { link = "Normal" },
				["TelescopePreviewTitle"] = { link = "TelescopeTitle" },
				["TelescopePromptBorder"] = { fg = colors.gray01, bg = colors.gray01 },
				["TelescopePromptCounter"] = { fg = colors.gray04, bg = colors.gray01 },
				["TelescopePromptNormal"] = { fg = colors.gray06, bg = colors.gray01 },
				["TelescopePromptTitle"] = { link = "TelescopeTitle" },
				["TelescopeResultsTitle"] = { link = "TelescopeTitle" },
				["TelescopeTitle"] = { fg = colors.magenta },
			}

			for group, opts in pairs(highlights) do
				vim.api.nvim_set_hl(0, group, opts)
			end
		end,
	},
	{
		"norcalli/nvim-colorizer.lua",
		event = "VeryLazy",
		opts = {},
	},
}
