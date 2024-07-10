return {
	{
		"kyazdani42/nvim-web-devicons",
		lazy = true,
		dependencies = { "nvim-lua/plenary.nvim" },
		opts = {
			override = {
				zsh = {
					icon = "",
					color = "#428850",
					name = "Zsh",
				},
			},
			-- globally enable default icons
			default = true,
		},
	},
}
