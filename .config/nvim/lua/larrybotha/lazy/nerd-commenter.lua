return {
  {
    'preservim/nerdcommenter',
    name = "nerdcommenter",
    init = function() 
      vim.g.NERDDefaultAlign = 'left'

      vim.api.nvim_create_autocmd("FileType", {
        pattern = "go",
        callback = function()
          vim.g.NERDCommentEmptyLines = 1
        end
      })
    end
  }
}
