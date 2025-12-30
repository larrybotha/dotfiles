return {
	"nvim-neorg/neorg",
	lazy = false, -- Disable lazy loading as some `lazy.nvim` distributions set `lazy = true` by default
	version = "*", -- Pin Neorg to the latest stable release
	config = function()
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
	end,
}
