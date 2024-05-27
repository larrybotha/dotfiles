return {
	{
		"kyazdani42/nvim-web-devicons",
		dependencies = { "nvim-lua/plenary.nvim" },
		lazy = true,
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
