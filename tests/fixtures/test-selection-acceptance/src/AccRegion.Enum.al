enum 50900 "Acc Region" implements "Acc Tax Rate"
{
    Extensible = false;

    value(0; DK)
    {
        Implementation = "Acc Tax Rate" = "Acc Tax DK";
    }
    value(1; DE)
    {
        Implementation = "Acc Tax Rate" = "Acc Tax DE";
    }
    value(2; Exempt)
    {
        Implementation = "Acc Tax Rate" = "Acc Tax Exempt";
    }
}
