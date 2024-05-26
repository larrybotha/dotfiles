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
