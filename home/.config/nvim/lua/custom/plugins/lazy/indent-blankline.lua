return {
	{
		"lukas-reineke/indent-blankline.nvim",
		name = "indent-blankline",
		main = "ibl",
		event = "VeryLazy",
		config = function()
			local ibl = require("ibl")
			local alignment = "left"

			-- "┊" or "▏"
			local char = "┊"

			if alignment == "left" then
				char = "▏"
			end

			ibl.setup({
				exclude = {
					buftypes = { "terminal" },
				},
				indent = { highlight = { "WinSeparator" }, char = char },
				scope = { enabled = false },
			})
		end,
	},
}
