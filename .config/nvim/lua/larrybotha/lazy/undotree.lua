return {
  {
    "mbbill/undotree",
    name="undotree",
    init = function()
      vim.keymap.set("n", "<leader>u", vim.cmd.UndotreeToggle)

      -- Persist undos to system
      -- With undotree allows for undo / redo across Neovim startups
      vim.opt.undodir = os.getenv("HOME") .. "/.vim/undodir"
      vim.opt.undofile = true
    end,
  }
}
