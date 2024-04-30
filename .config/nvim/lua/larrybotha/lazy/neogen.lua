return {
  'danymat/neogen',
  config = function()
    require("neogen").setup({
      enabled = true,
      languages = {
        python = { template = { annotation_convention = "numpydoc" } },
      },
    })

    vim.api.nvim_set_keymap("n", "<C-_>", ":lua require('neogen').generate()<CR>", {silent=true})
  end
}
