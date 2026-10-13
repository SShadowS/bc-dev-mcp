enum 50980 "Sel Carrier" implements "Sel Shipping Rate"
{
    Extensible = false;

    value(0; Standard)
    {
        Implementation = "Sel Shipping Rate" = "Sel Standard Rate";
    }
    value(1; Express)
    {
        Implementation = "Sel Shipping Rate" = "Sel Express Rate";
    }
}
