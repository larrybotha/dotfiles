return {
	"nvim-neorg/neorg",
	dependencies = {
		"nvim-neorg/tree-sitter-norg",
		"nvim-neorg/tree-sitter-norg-meta",
	},
	lazy = false, -- Disable lazy loading as some `lazy.nvim` distributions set `lazy = true` by default
	version = "*",
	config = function()
		-- see https://github.com/nvim-neorg/neorg/issues/1715#issuecomment-4174077279
		for _, name in ipairs({ "norg", "norg_meta" }) do
			local path, err = package.searchpath("parser." .. name, package.cpath)
			if path and not err then
				vim.opt.rtp:prepend({ path:gsub(("parser/%s%%.so"):format(name), "") })
			end
		end

		require("neorg").setup({
			load = {
				["core.defaults"] = {},
				["core.concealer"] = {},
				["core.dirman"] = {
					config = {
						workspaces = {
							monitor_lizard = "~/.config/neorg/workspaces/monitor-lizard",
							notes = "~/.config/neorg/workspaces/notes",
							scratch = "~/.config/neorg/workspaces/scratch",
							work = "~/.config/neorg/workspaces/work",
						},
					},
				},
			},
		})

		-- Expand 'norw' to 'Neorg workspace'
		vim.cmd([[cabbrev norw Neorg workspace]])
		-- Expand 'nori' to 'Neorg index'
		vim.cmd([[cabbrev nori Neorg index]])
	end,
}
